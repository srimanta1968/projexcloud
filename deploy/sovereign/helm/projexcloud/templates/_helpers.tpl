{{/*
Common helpers for the projexcloud chart.
*/}}

{{- define "projexcloud.fullname" -}}
{{- printf "%s" (.Release.Name | trunc 63 | trimSuffix "-") -}}
{{- end -}}

{{- define "projexcloud.image" -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.repository .Values.image.tag -}}
{{- end -}}

{{/* Base labels applied to every object. */}}
{{- define "projexcloud.labels" -}}
app.kubernetes.io/part-of: projexcloud
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
projexcloud.com/region: {{ .Values.region_id | default "unset" | quote }}
projexcloud.com/regime: {{ .Values.regime | default "unset" | quote }}
{{- end -}}

{{/* Per-component selector labels. Pass a dict {root, name}. */}}
{{- define "projexcloud.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{- define "projexcloud.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{ include "projexcloud.fullname" . }}-sa
{{- else -}}
default
{{- end -}}
{{- end -}}

{{- define "projexcloud.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ include "projexcloud.fullname" . }}-secrets
{{- end -}}
{{- end -}}
