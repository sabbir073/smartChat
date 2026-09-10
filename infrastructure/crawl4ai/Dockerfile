# The page reader: crawl4ai (https://github.com/unclecode/crawl4ai) and a headless Chromium,
# behind one HTTP endpoint (server.py). Built from the plain Python image rather than the
# upstream crawl4ai image: that one carries its own API server, Redis and supervisor, none of
# which is used here - the worker owns the crawl and asks this service for one page at a time.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app
COPY requirements.txt ./
# The Python packages, then the one browser and the system libraries it needs, in one layer each.
RUN pip install -r requirements.txt \
    && python -m playwright install --with-deps chromium \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /root/.cache
COPY server.py ./

# A non-root user that can read the browser but write nothing here.
RUN groupadd -r reader && useradd --no-log-init -r -g reader -d /home/reader -m reader \
    && chmod -R a+rX /opt/pw-browsers
USER reader
ENV PORT=3000 HOME=/home/reader
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=4).status == 200 else 1)"
CMD ["python", "server.py"]
