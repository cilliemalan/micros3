# Builder: Alpine (musl), so the binary links fully statically (design.md, D4).
FROM alpine:3.22 AS build
RUN apk add --no-cache build-base cmake git linux-headers
WORKDIR /src
COPY CMakeLists.txt ./
COPY lib lib
COPY src src
COPY test test
RUN cmake -S . -B /build -DCMAKE_BUILD_TYPE=Release -DMICROS3_STATIC=ON \
    && cmake --build /build --target micros3 -j"$(nproc)" \
    && strip /build/micros3 \
    && mkdir /data \
    && chown 65532:65532 /data

# Runtime: only the executable and the data directory (D8).
FROM scratch
COPY --from=build /build/micros3 /micros3
COPY --from=build --chown=65532:65532 /data /data
ENV MICROS3_DATA_DIR=/data MICROS3_PORT=3923 MICROS3_UI_PORT=3924
VOLUME /data
EXPOSE 3923 3924
USER 65532:65532
ENTRYPOINT ["/micros3"]
