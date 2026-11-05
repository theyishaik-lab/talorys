package com.talorys.localllm

/**
 * The on-device models. KEEP IN STEP with DEVICE_MODELS in packages/shared/src/device.ts — the
 * mobile test tests/local-models.test.ts parses this file and fails when the two disagree.
 *
 * Verified Nov 5, 2026 against https://huggingface.co/api/models/<repo>?blobs=true (pinned revisions).
 */
data class ModelSpec(
    val id: String,
    val name: String,
    val file: String,
    val url: String,
    val sizeBytes: Long,
    val sha256: String,
    val minRamGb: Double,
    val recommendedRamGb: Double,
    val contextTokens: Int,
    val maxOutputTokens: Int,
    val reasoning: Boolean,
    val thinkingBudgetTokens: Int,
    val preferGpu: Boolean,
)

object ModelSpecs {
    val ALL: List<ModelSpec> = listOf(
        ModelSpec(
            id = "spark-x2.5-1.7b",
            name = "Spark-X2.5 1.7B",
            file = "Spark-X2.5-1.7B_int8.litertlm",
            url = "https://huggingface.co/litert-community/Spark-X2.5-1.7B/resolve/3e8a954ea1cf4ab1aa7873ef6e7fe153334d5225/Spark-X2.5-1.7B_int8.litertlm",
            sizeBytes = 1_834_713_088L,
            sha256 = "81c32f0f319fbcbd7cce5695204f7a9cef90c3481f4ac545762087943932a0c0",
            minRamGb = 3.0,
            recommendedRamGb = 4.0,
            contextTokens = 4096,
            maxOutputTokens = 3072,
            reasoning = true,
            thinkingBudgetTokens = 1536,
            preferGpu = true,
        ),
        ModelSpec(
            id = "gemma-4-e4b",
            name = "Gemma 4 E4B",
            file = "gemma-4-E4B-it.litertlm",
            url = "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/71064b01bd5e2bfd9a5f9dd52df86ae4800138c1/gemma-4-E4B-it.litertlm",
            sizeBytes = 3_659_530_240L,
            sha256 = "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
            minRamGb = 6.0,
            recommendedRamGb = 8.0,
            contextTokens = 8192,
            maxOutputTokens = 2048,
            reasoning = false,
            thinkingBudgetTokens = 0,
            preferGpu = true,
        ),
    )

    fun byId(id: String): ModelSpec? = ALL.firstOrNull { it.id == id }
}
