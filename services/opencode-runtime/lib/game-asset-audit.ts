/** Read-only UE evidence collector. Plans are inputs, never inferred from the observed level. */
export interface WorldAuditInput {
  world_plan?: Record<string, unknown> | null
  assets?: Array<Record<string, unknown>>
}

export const WORLD_AUDIT_MARKER = "EIMU_WORLD_AUDIT:"

export function buildWorldAuditPython(input: WorldAuditInput): string {
  // A JSON string literal prevents asset names/paths from becoming executable Python.
  const payload = JSON.stringify(JSON.stringify(input))
  return `import unreal, json, hashlib, struct, os, math, stat, gzip, io
_audit_input = json.loads(${payload})
def _audit_run():
    plan = _audit_input.get("world_plan")
    manifest = _audit_input.get("assets")
    if not isinstance(manifest,list) or len(manifest)>256: manifest = []
    project_dir = os.path.realpath(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    actors = []
    for actor in actor_subsystem.get_all_level_actors():
        p, r, s = actor.get_actor_location(), actor.get_actor_rotation(), actor.get_actor_scale3d()
        mesh_paths = []
        for component in actor.get_components_by_class(unreal.StaticMeshComponent):
            mesh = component.get_editor_property("static_mesh")
            if mesh: mesh_paths.append(mesh.get_path_name())
        if hasattr(unreal,"GaussianSplatComponent"):
            for component in actor.get_components_by_class(unreal.GaussianSplatComponent):
                splat = component.get_editor_property("asset")
                if splat: mesh_paths.append(splat.get_path_name())
        actors.append({"label": actor.get_actor_label(), "path": actor.get_path_name(), "class_name": actor.get_class().get_name(), "location": [p.x,p.y,p.z], "rotation": [r.pitch,r.yaw,r.roll], "scale": [s.x,s.y,s.z], "asset_paths": mesh_paths})
    problems = []
    matches = []
    g2 = "unknown"
    tolerances = {"position_cm": 1.0, "rotation_degrees": 1.0, "scale": 0.01}
    if not isinstance(plan, dict) or not isinstance(plan.get("actors"), list) or not plan["actors"]:
        problems.append({"gate": "G2", "code": "world_plan_missing", "message": "需要独立设计文档的 world_plan.actors；不能从当前关卡反推设计自证。"})
    else:
        expected = plan["actors"]
        claimed = set()
        labels = set()
        g2 = "pass"
        for item in expected:
            errors = []
            if not isinstance(item, dict):
                matches.append({"status": "fail", "errors": ["invalid_actor_plan"]}); g2 = "fail"; continue
            label = item.get("label")
            if not isinstance(label, str) or not label or label in labels:
                matches.append({"label": label, "status": "fail", "errors": ["missing_or_duplicate_plan_label"]}); g2 = "fail"; continue
            labels.add(label)
            found = [a for a in actors if a["label"] == label]
            if len(found) != 1:
                matches.append({"label": label, "status": "fail", "errors": ["actor_count_mismatch"], "expected_count": 1, "actual_count": len(found)}); g2 = "fail"; continue
            actual = found[0]
            claimed.add(actual["path"])
            if not isinstance(item.get("class_name"), str) or actual["class_name"] != item["class_name"]: errors.append("class_mismatch")
            for field, tolerance in [("location", tolerances["position_cm"]), ("rotation", tolerances["rotation_degrees"]), ("scale", tolerances["scale"])]:
                value = item.get(field)
                if not isinstance(value, list) or len(value) != 3 or any(type(v) not in (int,float) or not math.isfinite(v) for v in value):
                    errors.append(field + "_plan_missing"); continue
                deltas = [abs(((a-b+180)%360)-180) if field == "rotation" else abs(a-b) for a,b in zip(actual[field], value)]
                error = math.sqrt(sum(d*d for d in deltas)) if field == "location" else max(deltas)
                if error > tolerance: errors.append(field + "_outside_tolerance")
            if item.get("asset_path") and item["asset_path"] not in actual["asset_paths"]: errors.append("asset_mismatch")
            if errors: g2 = "fail"
            matches.append({"label": label, "status": "fail" if errors else "pass", "errors": errors, "expected": item, "observed": actual})
        # Default is the complete level. A predeclared label prefix can scope a design to owned actors.
        prefix = plan.get("actor_label_prefix")
        scoped = [a for a in actors if not isinstance(prefix,str) or not prefix or a["label"].startswith(prefix)]
        extras = [a["label"] for a in scoped if a["path"] not in claimed]
        if extras:
            g2 = "fail"; problems.append({"gate": "G2", "code": "unexpected_actors", "labels": extras})
    assets = []
    ids = set()
    for entry in manifest:
        record = dict(entry) if isinstance(entry, dict) else {}
        errors, unknowns = [], []
        asset_id = record.get("id")
        if not isinstance(asset_id,str) or not asset_id or len(asset_id)>160 or asset_id in ids: errors.append("missing_or_duplicate_asset_id")
        else: ids.add(asset_id)
        path = record.get("local_path")
        source = record.get("source")
        if not isinstance(source, dict) or not isinstance(source.get("kind"),str) or not source["kind"] or not isinstance(source.get("uri"),str) or not source["uri"]: unknowns.append("source_missing")
        elif source["kind"] == "fixture" or source.get("origin_status") == "original_authoring_input_unknown": unknowns.append("independent_generation_receipt_missing")
        if type(record.get("cost_coins")) not in (int,float) or not math.isfinite(record["cost_coins"]) or record["cost_coins"] < 0: unknowns.append("cost_unknown")
        report = None
        asset_format = "spz" if isinstance(path,str) and path.lower().endswith(".spz") else "glb"
        try:
            if not isinstance(path, str) or not os.path.isabs(path): raise ValueError("absolute_local_path_required")
            if os.path.commonpath([project_dir,os.path.abspath(path)]) != project_dir: raise ValueError("asset_path_outside_project")
            current = project_dir
            for part in os.path.relpath(path,project_dir).split(os.sep):
                current = os.path.join(current,part)
                if stat.S_ISLNK(os.lstat(current).st_mode): raise ValueError("asset_symlink_denied")
            # Open relative to directory descriptors so a link swap between check and read cannot escape.
            relative_parts = os.path.relpath(os.path.abspath(path),project_dir).split(os.sep)
            directory_fd = os.open(project_dir,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:
                for part in relative_parts[:-1]:
                    child_fd = os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory_fd)
                    os.close(directory_fd)
                    directory_fd = child_fd
                file_fd = os.open(relative_parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory_fd)
                with os.fdopen(file_fd,"rb") as handle:
                    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode): raise ValueError("asset_not_regular_file")
                    data = handle.read(157286401)
            finally: os.close(directory_fd)
            if len(data) > 157286400: raise ValueError("asset_exceeds_150mb")
            report = {"format": asset_format, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "triangles": None}
            if asset_format == "spz":
                header = data[:32]
                if data[:2] == b"\\x1f\\x8b":
                    with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed: header = compressed.read(32)
                if len(header)<16 or header[:4] != b"NGSP": raise ValueError("invalid_spz_header")
                version, splat_count = struct.unpack_from("<II",header,4)
                if version not in (2,3,4) or not splat_count or (version==4 and len(header)<32): raise ValueError("unsupported_or_empty_spz")
                report.update({"version":version,"splats":splat_count,"triangle_check":"not_applicable_gaussian_splat"})
            else:
                if len(data) < 20 or data[:4] != b"glTF": raise ValueError("not_glb")
                version, total, length, chunk_type = struct.unpack_from("<IIII", data, 4)
                if version != 2 or total != len(data) or chunk_type != 0x4e4f534a or length % 4 or 20+length > len(data): raise ValueError("invalid_glb_header")
                gltf = json.loads(data[20:20+length])
                accessors = gltf.get("accessors",[])
                triangles = 0
                for mesh in gltf.get("meshes",[]):
                    for primitive in mesh.get("primitives",[]):
                        position = accessors[primitive["attributes"]["POSITION"]]
                        count = accessors[primitive["indices"]]["count"] if "indices" in primitive else position["count"]
                        mode = primitive.get("mode",4)
                        if mode == 4:
                            if count % 3: raise ValueError("incomplete_triangle_primitive")
                            triangles += count // 3
                        elif mode in (5,6): triangles += max(0,count-2)
                        else: raise ValueError("non_triangle_mesh_primitive")
                report.update({"triangles":triangles,"meshes":len(gltf.get("meshes",[]))})
            if record.get("sha256") and record["sha256"] != report["sha256"]: errors.append("sha256_mismatch")
            if asset_format == "glb":
                if type(record.get("triangles")) is int:
                    if record["triangles"] != triangles: errors.append("generated_triangle_report_mismatch")
                else: unknowns.append("generation_triangle_report_missing")
        except Exception as error: errors.append(str(error))
        loaded = []
        paths = record.get("ue_asset_paths")
        if not isinstance(paths,list) or not paths or len(paths)>256 or any(not isinstance(p,str) or not p.startswith("/Game/") or len(p)>1024 for p in paths): errors.append("ue_asset_paths_missing_or_invalid")
        else:
            if len(set(paths)) != len(paths): errors.append("duplicate_ue_asset_path")
            for asset_path in paths:
                mesh_record = {"path": asset_path, "loaded": False, "triangles": None}
                try:
                    asset = unreal.load_asset(asset_path)
                    mesh_record["loaded"] = asset is not None
                    if asset is None: errors.append("ue_load_asset_failed:"+str(asset_path))
                    elif asset_format == "glb" and isinstance(asset,unreal.StaticMesh):
                        mesh_record["triangles"] = asset.get_num_triangles(0)
                    elif asset_format == "spz" and hasattr(unreal,"GaussianSplat") and isinstance(asset,unreal.GaussianSplat):
                        mesh_record["splats"] = asset.get_editor_property("num_splats")
                        mesh_record["triangle_check"] = "not_applicable_gaussian_splat"
                        if report and mesh_record["splats"] != report.get("splats"): errors.append("ue_splat_count_mismatch")
                    else: errors.append("ue_asset_type_mismatch:"+str(asset_path))
                except Exception as error:
                    unknowns.append("ue_triangle_read_failed:"+str(error))
                loaded.append(mesh_record)
            counts = [m["triangles"] for m in loaded]
            if asset_format == "glb" and report and counts and all(type(n) is int for n in counts) and sum(counts) != report["triangles"]: errors.append("ue_triangle_count_mismatch")
        record.update({"observed_asset": report,"observed_glb": report if asset_format == "glb" else None, "ue_assets": loaded, "errors": errors, "unknowns": unknowns, "status": "fail" if errors else "unknown" if unknowns else "pass"})
        assets.append(record)
    g3 = "fail" if any(a["status"] == "fail" for a in assets) else "unknown" if not assets or any(a["status"] == "unknown" for a in assets) else "pass"
    if not assets: problems.append({"gate": "G3", "code": "asset_manifest_missing"})
    report = {"schema": "eimu.ue_world_audit/v1", "engine_version": unreal.SystemLibrary.get_engine_version(), "world": world.get_path_name() if world else None, "status": "pass" if g2 == g3 == "pass" else "fail" if "fail" in [g2,g3] else "unknown", "gates": {"G2": g2, "G3": g3}, "tolerances": tolerances, "actors": actors, "actor_matches": matches, "assets": assets, "problems": problems, "note": "只证明 G2/G3；费用为来源记录，授权与真实扣费须另对账 G6。"}
    return "${WORLD_AUDIT_MARKER}"+json.dumps(report,ensure_ascii=False,allow_nan=False)
_audit_run()`
}

/** MCP servers may nest Python output as JSON text; missing/truncated receipts stay unknown. */
export function parseWorldAuditResult(result: unknown): Record<string, unknown> {
  const texts: string[] = []
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 12) return
    if (typeof value === "string") {
      texts.push(value)
      try { walk(JSON.parse(value), depth + 1) } catch {}
    } else if (Array.isArray(value)) value.forEach(v => walk(v, depth + 1))
    else if (value && typeof value === "object") Object.values(value).forEach(v => walk(v, depth + 1))
  }
  walk(result)
  for (const text of texts) {
    // Error strings and actor labels may contain reflected input. Only a complete root receipt qualifies.
    if (!text.startsWith(WORLD_AUDIT_MARKER)) continue
    const line = text.slice(WORLD_AUDIT_MARKER.length).trim()
    try {
      const parsed = JSON.parse(line)
      const statuses = ["pass", "fail", "unknown"]
      if (parsed.schema === "eimu.ue_world_audit/v1" && statuses.includes(parsed.status)
        && statuses.includes(parsed.gates?.G2) && statuses.includes(parsed.gates?.G3)
        && Array.isArray(parsed.actors) && Array.isArray(parsed.assets) && Array.isArray(parsed.problems)) return parsed
    } catch {}
  }
  return { schema: "eimu.ue_world_audit/v1", status: "unknown", gates: { G2: "unknown", G3: "unknown" }, error: "audit_receipt_missing", message: "UE 未返回完整对账回执；不能把超时、截断或 Python 失败视为通过。" }
}
