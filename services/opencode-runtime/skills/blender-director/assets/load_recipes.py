"""bpy loading recipes for the Eimu local base asset library.

Verified on: bridge host (this workstation, Arch Linux x86_64), Blender 5.2.1 LTS
(build 2026-08-25, commit date 2026-08-24), headless (`blender -b`), 2026-10-22.
Every function below was executed in that environment in one probe scene:
HDRI world load, human-base append, PBR texture apply and GLB append, followed by
a 512x512 EEVEE render.

Each function is standalone: copy the one you need into a bpy script, or
`sys.path.insert(0, <this dir>)` and import it.

Asset paths are relative to `$BLENDER_WORK/assets/` unless a caller passes an
absolute path. See CATALOG.md for the inventory and manifest.json for hashes.
"""

import os

import bpy


# ---------------------------------------------------------------------------
# HDRIs
# ---------------------------------------------------------------------------

def load_hdri(path, strength=1.0, background=True):
    """Load an HDR image as the world environment and rebuild the world tree.

    path:       absolute path, or relative to $BLENDER_WORK/assets
    strength:   Background strength (lighting intensity)
    background: True  -> the HDR is visible behind the scene (camera ray)
                False -> lighting only (use a black background for product shots)

    Returns the world name.
    """
    path = _resolve(path)
    scene = bpy.context.scene
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("World")
        scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputWorld")
    out.location = (300, 0)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.location = (100, 0)
    bg.inputs["Strength"].default_value = float(strength)
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.location = (-200, 0)
    image = bpy.data.images.load(path, check_existing=True)
    image.colorspace_settings.name = "sRGB"
    env.image = image

    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    if not background:
        # Keep the HDR as the light source but show a neutral backdrop.
        lp = nt.nodes.new("ShaderNodeLightPath")
        lp.location = (100, 250)
        mix = nt.nodes.new("ShaderNodeMixShader")
        mix.location = (150, 100)
        black = nt.nodes.new("ShaderNodeBackground")
        black.location = (-50, 200)
        black.inputs["Color"].default_value = (0.02, 0.02, 0.02, 1.0)
        black.inputs["Strength"].default_value = 1.0
        nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
        nt.links.new(bg.outputs["Background"], mix.inputs[1])
        nt.links.new(black.outputs["Background"], mix.inputs[2])
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])

    return world.name


# ---------------------------------------------------------------------------
# Human base meshes (Blender Studio bundle)
# ---------------------------------------------------------------------------

# variant -> (asset collection name, primary body object name)
HUMAN_VARIANTS = {
    "male_realistic": ("Body Male - Realistic", "GEO-body_male_realistic"),
    "female_realistic": ("Body Female - Realistic", "GEO-body_female_realistic"),
    "male_stylized": ("Body Male - Stylized", "GEO-body_male_stylized"),
    "female_stylized": ("Body Female - Stylized", "GEO-body_female_stylized"),
}


def append_human_base(path, variant="male_realistic", collection=None):
    """Append one human base-mesh collection from the Blender Studio bundle.

    path:       humans/human-base-meshes.blend (or absolute)
    variant:    one of HUMAN_VARIANTS keys; ignored when `collection` is given
    collection: exact asset collection name, e.g. "Head (Sculpting) - Realistic",
                "Skeleton - Realistic", "Body Male - Primitve (Realistic)"

    Returns the primary object name (e.g. "GEO-body_male_realistic").
    The whole collection (body + eyes, or head + eyes, or skeleton parts) is
    linked into the current scene.
    """
    path = _resolve(path)
    if collection is None:
        try:
            collection, primary = HUMAN_VARIANTS[variant]
        except KeyError:
            raise ValueError(
                f"unknown variant {variant!r}; use one of {sorted(HUMAN_VARIANTS)}"
            )
    else:
        primary = collection

    with bpy.data.libraries.load(path, link=False) as (src, dst):
        if collection not in src.collections:
            raise KeyError(
                f"collection {collection!r} not found in {path}; "
                f"available: {sorted(src.collections)}"
            )
        dst.collections = [collection]

    coll = dst.collections[0]
    if coll is None:
        raise RuntimeError(f"append failed for collection {collection!r}")

    scene = bpy.context.scene
    if coll.name not in scene.collection.children:
        scene.collection.children.link(coll)

    for obj in coll.objects:
        obj.hide_viewport = False
        obj.hide_render = False
        if obj.name not in scene.collection.objects:
            scene.collection.objects.link(obj)

    body = coll.objects.get(primary)
    if body is not None:
        return body.name
    # Blender may suffix a name on collision; fall back to the first mesh.
    for obj in coll.objects:
        if obj.type == "MESH":
            return obj.name
    raise RuntimeError(f"no mesh object appended from collection {collection!r}")


# ---------------------------------------------------------------------------
# PBR texture sets
# ---------------------------------------------------------------------------

def apply_pbr_texture(obj, set_dir, material_name=None, uv_scale=1.0):
    """Build a Principled material from a Poly Haven texture set and assign it.

    set_dir: textures/brushed_concrete_03, textures/metal_plate_02,
             textures/fabric_leather_02 (or absolute)
             Expected files: diffuse.jpg, roughness.jpg, normal.jpg (OpenGL normal)
    uv_scale: tiling multiplier (Mapping node scale). 1.0 = one UV tile.
    material_name: defaults to "M_<object>_<set>"

    Wires: Base Color <- diffuse (sRGB)
           Roughness  <- roughness (Non-Color)
           Normal     <- normal (Non-Color) -> Normal Map node
    Uses the mesh UV map when present; falls back to Generated coordinates.

    Returns a dict with material name, node types and the coordinate source.
    """
    set_dir = _resolve(set_dir)
    if obj.type != "MESH":
        raise TypeError(f"apply_pbr_texture needs a MESH object, got {obj.type!r}")

    for slot in ("diffuse", "roughness", "normal"):
        p = os.path.join(set_dir, slot + ".jpg")
        if not os.path.isfile(p):
            raise FileNotFoundError(f"missing {slot} map: {p}")

    mat = bpy.data.materials.new(material_name or f"M_{obj.name}_{os.path.basename(set_dir)}")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (520, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (200, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    has_uv = bool(obj.data.uv_layers)
    texco = nt.nodes.new("ShaderNodeTexCoord")
    texco.location = (-620, 0)
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.location = (-420, 0)
    mapping.inputs["Scale"].default_value = (uv_scale, uv_scale, 1.0)
    nt.links.new(texco.outputs["UV" if has_uv else "Generated"], mapping.inputs["Vector"])

    def image_node(slot, colorspace):
        img = bpy.data.images.load(os.path.join(set_dir, slot + ".jpg"), check_existing=True)
        img.colorspace_settings.name = colorspace
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        node.label = slot
        node.location = (-220, {"diffuse": 220, "roughness": 0, "normal": -220}[slot])
        nt.links.new(mapping.outputs["Vector"], node.inputs["Vector"])
        return node

    diffuse = image_node("diffuse", "sRGB")
    roughness = image_node("roughness", "Non-Color")
    normal = image_node("normal", "Non-Color")

    nt.links.new(diffuse.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(roughness.outputs["Color"], bsdf.inputs["Roughness"])

    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.location = (0, -220)
    nmap.inputs["Strength"].default_value = 1.0
    nt.links.new(normal.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    obj.data.materials.clear()
    obj.data.materials.append(mat)

    return {
        "material": mat.name,
        "nodes": sorted({n.bl_idname for n in nt.nodes}),
        "coords": "UV" if has_uv else "Generated",
    }


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

def append_model(path):
    """Append a model from the library.

    .glb / .gltf -> glTF import (textures are embedded in the .glb)
    .blend       -> bpy.data.libraries.load(objects) + link into the scene

    Returns the list of newly created object names.
    """
    path = _resolve(path)
    before = {o.as_pointer() for o in bpy.data.objects}
    ext = os.path.splitext(path)[1].lower()

    if ext in (".glb", ".gltf"):
        result = bpy.ops.import_scene.gltf(filepath=path)
        if "FINISHED" not in result:
            raise RuntimeError(f"glTF import failed for {path}: {result}")
    elif ext == ".blend":
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            dst.objects = list(src.objects)
        scene = bpy.context.scene
        for obj in dst.objects:
            if obj is None:
                continue
            if not obj.users_collection:
                scene.collection.objects.link(obj)
            for coll in obj.users_collection:
                if coll.name not in scene.collection.children:
                    try:
                        scene.collection.children.link(coll)
                    except RuntimeError:
                        pass
    else:
        raise ValueError(f"unsupported model format {ext!r}; expected .glb, .gltf or .blend")

    new = [o.name for o in bpy.data.objects if o.as_pointer() not in before]
    if not new:
        raise RuntimeError(f"nothing appended from {path}")
    return new


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _resolve(path):
    """Accept absolute paths, or paths relative to $BLENDER_WORK/assets.

    Both "hdri/studio_small_09.hdr" and "assets/hdri/studio_small_09.hdr"
    resolve against $BLENDER_WORK/assets (the leading "assets/" is stripped).
    """
    path = os.path.expanduser(str(path))
    if os.path.isabs(path):
        return path
    rel = path[2:] if path.startswith("./") else path
    if rel.startswith("assets/"):
        rel = rel[len("assets/"):]
    work = os.environ.get("BLENDER_WORK")
    if work:
        candidate = os.path.join(work, "assets", rel)
    else:
        candidate = os.path.join(
            os.path.expanduser("~"), "Desktop", "image-app", ".blender-work", "assets", rel
        )
    return candidate if os.path.exists(candidate) else path
