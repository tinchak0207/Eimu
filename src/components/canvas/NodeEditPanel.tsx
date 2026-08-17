import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NodeEditPanelProps {
  nodeId: string;
  initialPrompt: string;
  initialModel?: string;
  initialSize?: string;
  initialShotSize?: string;
  initialCameraMove?: string;
  onSave: (nodeId: string, patch: Record<string, unknown>) => void;
  onCancel: () => void;
}

export function NodeEditPanel({
  nodeId,
  initialPrompt,
  initialModel,
  initialSize,
  initialShotSize,
  initialCameraMove,
  onSave,
  onCancel,
}: NodeEditPanelProps) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [model, setModel] = useState(initialModel || "");
  const [size, setSize] = useState(initialSize || "");
  const [shotSize, setShotSize] = useState(initialShotSize || "中景");
  const [cameraMove, setCameraMove] = useState(initialCameraMove || "固定");

  const handleSave = () => {
    const patch: Record<string, unknown> = {};
    if (prompt !== initialPrompt) patch.prompt = prompt;
    if (model && model !== initialModel) patch.model = model;
    if (size && size !== initialSize) patch.size = size;
    if (shotSize !== initialShotSize) patch.shot_size = shotSize;
    if (cameraMove !== initialCameraMove) patch.camera_move = cameraMove;
    
    if (Object.keys(patch).length > 0) {
      onSave(nodeId, patch);
    }
    onCancel();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">編輯節點</h3>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">提示詞</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">景別</label>
              <select
                value={shotSize}
                onChange={(e) => setShotSize(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              >
                <option value="特寫">特寫</option>
                <option value="近景">近景</option>
                <option value="中景">中景</option>
                <option value="全景">全景</option>
                <option value="遠景">遠景</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">運鏡</label>
              <select
                value={cameraMove}
                onChange={(e) => setCameraMove(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              >
                <option value="固定">固定</option>
                <option value="推進">推進</option>
                <option value="拉遠">拉遠</option>
                <option value="搖鏡">搖鏡</option>
                <option value="跟拍">跟拍</option>
              </select>
            </div>
          </div>

          {model && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">模型</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {size && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">尺寸</label>
              <input
                type="text"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            儲存
          </button>
        </div>
      </div>
    </div>
  );
}