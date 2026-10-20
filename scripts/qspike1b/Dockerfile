# QSPIKE1b: one image, two builds of the same llama.cpp commit. Only the instruction-set
# flags differ between them, so a difference in throughput is attributable to the build.
# Native detection is off in both: a native build detects Railway's builder, not the host
# the container lands on, which may be the original defect over again.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG LLAMA_COMMIT=4762ad7316dcdec20016ab5985fb46a27902204d
RUN git clone https://github.com/ggml-org/llama.cpp /src && cd /src && git checkout ${LLAMA_COMMIT}
# generic: no AVX at all, the shape of a wheel built for the lowest common x86-64
RUN cmake -S /src -B /build-generic -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF \
      -DGGML_NATIVE=OFF -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF \
      -DGGML_AVX512=OFF -DGGML_AVX512_VNNI=OFF -DGGML_AVX_VNNI=OFF -DBUILD_SHARED_LIBS=OFF \
 && cmake --build /build-generic -j --target llama-cli
# isa: exactly what the host check found (docs/ai/measurements/QSPIKE1b.md, Host)
RUN cmake -S /src -B /build-isa -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF \
      -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
      -DGGML_AVX512=ON -DGGML_AVX512_VNNI=ON -DGGML_AVX_VNNI=ON -DBUILD_SHARED_LIBS=OFF \
 && cmake --build /build-isa -j --target llama-cli

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl time coreutils && rm -rf /var/lib/apt/lists/*
COPY --from=build /build-generic/bin/llama-cli /opt/generic/llama-cli
COPY --from=build /build-isa/bin/llama-cli /opt/isa/llama-cli
# Qwen3-4B Q4_K_M, the 4B QSPIKE1 fell back to. QSPIKE1's exact file was never pushed, so
# this is the official Qwen GGUF, pinned by its sha256.
ARG GGUF_SHA256=7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5
RUN curl -fsSL -o /opt/model.gguf \
      https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf \
 && echo "${GGUF_SHA256}  /opt/model.gguf" | sha256sum -c -
COPY prompt.txt run.sh /opt/
RUN chmod +x /opt/run.sh
CMD ["/opt/run.sh"]
