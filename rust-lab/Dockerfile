FROM rust:1.88-bookworm AS build
WORKDIR /build
COPY rust-lab/Cargo.toml rust-lab/Cargo.lock ./
COPY rust-lab/src ./src
RUN cargo build --locked --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 lab
COPY --from=build /build/target/release/rust-event-loop-lab /usr/local/bin/rust-event-loop-lab
USER lab
EXPOSE 3000
CMD ["rust-event-loop-lab"]
