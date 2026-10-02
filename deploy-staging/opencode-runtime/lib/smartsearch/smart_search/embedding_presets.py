from dataclasses import dataclass


@dataclass(frozen=True)
class EmbeddingPreset:
    preset_id: str
    api_url: str
    model: str
    threshold: str
    margin: str
    description: str


QWEN3_EMBEDDING_8B_PRESET = EmbeddingPreset(
    preset_id="qwen3-embedding-8b",
    api_url="https://api.siliconflow.cn/v1/embeddings",
    model="Qwen/Qwen3-Embedding-8B",
    threshold="0.475",
    margin="0.053",
    description="Qwen3-Embedding-8B calibrated on Smart Search built-in route examples",
)


RECOMMENDED_EMBEDDING_PRESETS = {
    QWEN3_EMBEDDING_8B_PRESET.preset_id: QWEN3_EMBEDDING_8B_PRESET,
}


def embedding_preset_for_model(model: str) -> EmbeddingPreset | None:
    normalized = model.strip().lower()
    if normalized == QWEN3_EMBEDDING_8B_PRESET.model.lower():
        return QWEN3_EMBEDDING_8B_PRESET
    return None


def embedding_threshold_commands(preset: EmbeddingPreset) -> list[str]:
    return [
        f"smart-search config set INTENT_EMBEDDING_THRESHOLD {preset.threshold}",
        f"smart-search config set INTENT_EMBEDDING_MARGIN {preset.margin}",
    ]
