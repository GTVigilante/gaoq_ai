ARG NODE_BUILDER_IMAGE=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50

FROM ${NODE_BUILDER_IMAGE} AS dependencies
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches patches
COPY apps/erp-api/package.json apps/erp-api/package.json
COPY apps/erp-web/package.json apps/erp-web/package.json
COPY apps/payroll-api/package.json apps/payroll-api/package.json
COPY apps/payroll-web/package.json apps/payroll-web/package.json
COPY apps/payroll-worker/package.json apps/payroll-worker/package.json
COPY apps/website/package.json apps/website/package.json
COPY packages/payroll-core/package.json packages/payroll-core/package.json
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/shared-utils/package.json packages/shared-utils/package.json
COPY tools/mcp-inspector-client/package.json tools/mcp-inspector-client/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS contracts-build
COPY packages packages
RUN pnpm --filter @gaoq/shared-types build && \
    pnpm --filter @gaoq/platform-contracts build && \
    pnpm --filter @gaoq/payroll-core build

FROM contracts-build AS api-build
COPY apps/payroll-api apps/payroll-api
RUN pnpm --filter @gaoq/payroll-api build && \
    pnpm --filter @gaoq/payroll-api deploy --prod --legacy /runtime/payroll-api

FROM contracts-build AS worker-build
COPY apps/payroll-worker apps/payroll-worker
RUN pnpm --filter @gaoq/payroll-worker build && \
    pnpm --filter @gaoq/payroll-worker deploy --prod --legacy /runtime/payroll-worker

FROM dependencies AS web-build
ARG NEXT_PUBLIC_PAYROLL_ORIGIN
ENV NEXT_PUBLIC_PAYROLL_ORIGIN=${NEXT_PUBLIC_PAYROLL_ORIGIN}
COPY apps/payroll-web apps/payroll-web
RUN node -e "const endpoint = new URL(process.env.NEXT_PUBLIC_PAYROLL_ORIGIN); if (endpoint.protocol !== 'https:' || !['/', '/payroll', '/payroll/'].includes(endpoint.pathname) || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) process.exit(1)" && \
    pnpm --filter @gaoq/payroll-web build

FROM ${NODE_RUNTIME_IMAGE} AS runtime-base
ARG IMAGE_REVISION=unknown
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
ENV NEXT_TELEMETRY_DISABLED=1
LABEL org.opencontainers.image.source="https://github.com/GTVigilante/gaoq_ai" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.vendor="GaoQ-OS"
USER 65532:65532

FROM runtime-base AS payroll-api
ENV PORT=3101
COPY --from=api-build --chown=65532:65532 /runtime/payroll-api/package.json ./package.json
COPY --from=api-build --chown=65532:65532 /runtime/payroll-api/node_modules/ ./node_modules/
COPY --from=api-build --chown=65532:65532 /runtime/payroll-api/dist/ ./dist/
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3101/api/payroll/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/main.js"]

FROM runtime-base AS payroll-worker
COPY --from=worker-build --chown=65532:65532 /runtime/payroll-worker/package.json ./package.json
COPY --from=worker-build --chown=65532:65532 /runtime/payroll-worker/node_modules/ ./node_modules/
COPY --from=worker-build --chown=65532:65532 /runtime/payroll-worker/dist/ ./dist/
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "try{process.kill(1,0)}catch{process.exit(1)}"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/main.js"]

FROM runtime-base AS payroll-web
ENV HOSTNAME=0.0.0.0
ENV PORT=3100
COPY --from=web-build --chown=65532:65532 /workspace/apps/payroll-web/.next/standalone/ ./
COPY --from=web-build --chown=65532:65532 /workspace/apps/payroll-web/.next/static/ ./apps/payroll-web/.next/static/
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3100/payroll').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["apps/payroll-web/server.js"]
