# The page renderer: Chromium and Playwright, behind one HTTP endpoint (server.mjs).
# Microsoft's image carries the browser and its system libraries; the same Playwright version is
# pinned in package.json so the driver and the browser agree.
FROM mcr.microsoft.com/playwright:v1.50.1-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./

USER pwuser
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.mjs"]
