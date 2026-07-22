{{- define "gaoq-erp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "gaoq-erp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "gaoq-erp.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "gaoq-erp.labels" -}}
app.kubernetes.io/name: {{ include "gaoq-erp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: gaoq-os
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "gaoq-erp.serviceAccountName" -}}
{{- required "serviceAccount.name 必填" .Values.serviceAccount.name -}}
{{- end -}}

{{- define "gaoq-erp.targetNamespace" -}}
{{- required "targetNamespace 必填" .Values.targetNamespace -}}
{{- end -}}

{{- define "gaoq-erp.image" -}}
{{- printf "%s@%s" (required "镜像仓库必填" .repository) (required "镜像摘要必填" .digest) -}}
{{- end -}}
