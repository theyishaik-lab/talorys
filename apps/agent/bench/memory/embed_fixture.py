#!/usr/bin/env python3
"""Precomputes bge-m3 dense vectors for a memory-search bench fixture, so the hybrid
(BM25 + vectors) slice of `npm run bench:memory` runs offline and free.

It embeds exactly the texts the agent embeds: each memory as `content + "\n" + category`
(see `embeddingText` in src/semantic/embeddings.ts) and each query as typed. Vectors are the
bge-m3 dense output (CLS token of the last hidden state, L2-normalized), the same model Workers AI
serves as `@cf/baai/bge-m3`, run locally from the ONNX export (fp16). Values match Workers AI to
about two decimal places of cosine, not bit for bit: the live floors still decide what the
production recall keeps.

Output: `<fixture>.embeddings.json` next to the fixture:
  { "model", "source", "dims", "vectors": { "<sha256(text)[:16]>": "<scale>:<base64 int8>" } }
Each vector is stored as int8 with one float scale (value = int8 * scale), about 1.4 KB a text.

  pip install onnxruntime tokenizers numpy
  # model (1.1 GB): https://huggingface.co/Xenova/bge-m3 -> onnx/model_fp16.onnx + tokenizer.json
  python3 bench/memory/embed_fixture.py bench/memory/fixture.json --model-dir /tmp/bge

Never commit an embeddings file made from a private fixture.
"""
import argparse
import base64
import hashlib
import json
import os
import sys

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


def key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("fixture")
    ap.add_argument("--model-dir", default="/tmp/bge")
    ap.add_argument("--onnx", default="model_fp16.onnx")
    ap.add_argument("--out")
    args = ap.parse_args()

    with open(args.fixture, encoding="utf-8") as f:
        fixture = json.load(f)
    texts = [f"{m['content']}\n{m.get('category', 'other')}" for m in fixture["memories"]]
    texts += [q["q"] for q in fixture["queries"]]
    texts = list(dict.fromkeys(texts))

    tok = Tokenizer.from_file(os.path.join(args.model_dir, "tokenizer.json"))
    tok.enable_truncation(max_length=512)
    session = ort.InferenceSession(os.path.join(args.model_dir, args.onnx), providers=["CPUExecutionProvider"])

    vectors = {}
    for i in range(0, len(texts), 8):
        batch = texts[i : i + 8]
        enc = tok.encode_batch(batch)
        width = max(len(e.ids) for e in enc)
        ids = np.array([e.ids + [1] * (width - len(e.ids)) for e in enc], dtype=np.int64)  # <pad> = 1
        mask = np.array([[1] * len(e.ids) + [0] * (width - len(e.ids)) for e in enc], dtype=np.int64)
        (hidden,) = session.run(["last_hidden_state"], {"input_ids": ids, "attention_mask": mask})
        cls = hidden[:, 0, :].astype(np.float32)
        cls /= np.linalg.norm(cls, axis=1, keepdims=True)
        for text, v in zip(batch, cls):
            scale = float(np.abs(v).max()) / 127.0
            q = np.round(v / scale).astype(np.int8)
            vectors[key(text)] = f"{scale:.9g}:{base64.b64encode(q.tobytes()).decode()}"
        print(f"{min(i + 8, len(texts))}/{len(texts)}", file=sys.stderr)

    out = args.out or os.path.splitext(args.fixture)[0] + ".embeddings.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(
            {
                "model": "@cf/baai/bge-m3",
                "source": f"Xenova/bge-m3 {args.onnx} (CLS, L2-normalized), int8-quantized",
                "dims": 1024,
                "vectors": vectors,
            },
            f,
            separators=(",", ":"),
        )
        f.write("\n")
    print(f"wrote {out} ({len(vectors)} vectors)", file=sys.stderr)


if __name__ == "__main__":
    main()
