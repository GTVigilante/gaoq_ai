{{- define "gaoq-platform-guardrails.labels" -}}
app.kubernetes.io/name: gaoq-platform-guardrails
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: gaoq-os
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "gaoq-platform-guardrails.policyName" -}}
{{- printf "gaoq-%s-deployment" .Values.releaseName | trunc 63 | trimSuffix "-" -}}
{{- end -}}
