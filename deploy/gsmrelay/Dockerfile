# The virtual network's relay (gsmrelay/smsrelay/relay.py: SMS, calls and
# USSD between the emulator's pages) on its own, with the WebSocket the
# page's /gsmrelay is passed to. See README.md.
#
# Built from the repository root, where the gsmrelay submodule is:
#
#   git submodule update --init gsmrelay
#   docker build -f deploy/gsmrelay/Dockerfile -t pmb887x-gsmrelay .
#
# No BuildKit-only syntax, so docker-compose v1's classic builder builds it.

FROM python:3.13.18-slim-trixie@sha256:168d3a5d10f2152f8e8d77b6843ac82c22a846cfefeef7afdf9aa630404e82a7

# ffmpeg turns the clips and the built-in melody into GSM-FR frames when the
# relay starts (its libgsm encoder; without it every call is silent)
RUN apt-get update \
	&& apt-get install --no-install-recommends -y ffmpeg=7:7.1.5-0+deb13u1 \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd --system --uid 1000 --home-dir /var/lib/gsmrelay --shell /usr/sbin/nologin relay \
	&& install -d -o relay -g relay -m 0750 /var/lib/gsmrelay

COPY gsmrelay/smsrelay/relay.py /opt/gsmrelay/smsrelay/relay.py
COPY gsmrelay/clip/ /opt/gsmrelay/clip/
COPY deploy/gsmrelay/entrypoint.sh deploy/gsmrelay/healthcheck.py /opt/gsmrelay/

ENV PYTHONDONTWRITEBYTECODE=1 \
	PYTHONUNBUFFERED=1
USER relay
WORKDIR /var/lib/gsmrelay
VOLUME /var/lib/gsmrelay
EXPOSE 4726
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD ["python3", "/opt/gsmrelay/healthcheck.py"]
ENTRYPOINT ["sh", "/opt/gsmrelay/entrypoint.sh"]
