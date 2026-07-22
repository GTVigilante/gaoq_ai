ARG NODE_BUILDER_IMAGE=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50

FROM ${NODE_BUILDER_IMAGE} AS dependencies
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/erp-api/package.json apps/erp-api/package.json
COPY apps/erp-web/package.json apps/erp-web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/shared-utils/package.json packages/shared-utils/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS api-build
COPY apps/erp-api apps/erp-api
COPY packages packages
RUN pnpm --filter @gaoq/shared-types build && \
    pnpm --filter @gaoq/shared-utils build && \
    pnpm --filter @gaoq/erp-api build && \
    pnpm --filter @gaoq/erp-api deploy --prod --legacy /runtime/erp-api

FROM dependencies AS web-build
ARG NEXT_PUBLIC_ERP_API_ORIGIN
ENV NEXT_PUBLIC_ERP_API_ORIGIN=${NEXT_PUBLIC_ERP_API_ORIGIN}
COPY apps/erp-web apps/erp-web
RUN node -e "const endpoint = new URL(process.env.NEXT_PUBLIC_ERP_API_ORIGIN); if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) process.exit(1)" && \
    pnpm --filter @gaoq/erp-web build

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

FROM runtime-base AS erp-api
ENV PORT=3001
COPY --from=api-build --chown=65532:65532 /runtime/erp-api/ ./
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3001/api/health/live').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/main.js"]

FROM runtime-base AS erp-worker
ENV WORKER_METRICS_PORT=9464
COPY --from=api-build --chown=65532:65532 /runtime/erp-api/ ./
EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:9464/health/live').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/worker-main.js"]

FROM runtime-base AS erp-web
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=web-build --chown=65532:65532 /workspace/apps/erp-web/.next/standalone/ ./
COPY --from=web-build --chown=65532:65532 /workspace/apps/erp-web/.next/static/ ./apps/erp-web/.next/static/
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["apps/erp-web/server.js"]
