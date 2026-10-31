FROM ubuntu:24.04 AS tests

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl dbus-user-session ffmpeg git nodejs procps python3 python-is-python3 \
    systemd systemd-sysv tmux unzip util-linux \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu 24.04 already supplies the unprivileged ubuntu user (uid 1000).
USER ubuntu
ENV HOME=/home/ubuntu
ENV PATH=/home/ubuntu/.local/bin:/home/ubuntu/.bun/bin:/usr/local/bin:/usr/bin:/bin
ENV TEMP=/home/ubuntu/claude-telegram-hub/.tmp
ENV TMP=/home/ubuntu/claude-telegram-hub/.tmp
ENV TMPDIR=/home/ubuntu/claude-telegram-hub/.tmp
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN mkdir -p "$TMPDIR" && curl -fsSL https://bun.sh/install | bash
WORKDIR /home/ubuntu/claude-telegram-hub
COPY --chown=ubuntu:ubuntu . .
RUN mkdir -p .tmp && cd plugin && bun install --frozen-lockfile
CMD ["bash", "scripts/test-linux.sh"]

# --target systemd supports the separate user-service checks documented beside it.
FROM tests AS systemd
USER root
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

FROM tests AS claude
# Official native stable installer: https://code.claude.com/docs/en/setup
RUN curl -fsSL https://claude.ai/install.sh | bash -s stable
ENV TELEGRAM_HUB_CONTAINER_TEST=1
CMD ["bash", "scripts/test-claude-linux.sh"]
