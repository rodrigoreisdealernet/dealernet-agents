{{/*
Expand the name of the chart.
*/}}
{{- define "app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "app.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "app.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every resource.
*/}}
{{- define "app.labels" -}}
helm.sh/chart: {{ include "app.chart" . }}
{{ include "app.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Base selector labels (release + chart name).
*/}}
{{- define "app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Frontend fully-qualified name.
*/}}
{{- define "app.frontend.fullname" -}}
{{- printf "%s-frontend" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Frontend selector labels.
*/}}
{{- define "app.frontend.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-frontend" (include "app.name" .) | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Temporal-worker fully-qualified name.
*/}}
{{- define "app.temporalWorker.fullname" -}}
{{- printf "%s-temporal-worker" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Temporal-worker selector labels.
*/}}
{{- define "app.temporalWorker.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-temporal-worker" (include "app.name" .) | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Ops-api fully-qualified name.
*/}}
{{- define "app.opsApi.fullname" -}}
{{- printf "%s-ops-api" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Ops-api selector labels.
*/}}
{{- define "app.opsApi.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-ops-api" (include "app.name" .) | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
OAuth2-proxy fully-qualified name.
*/}}
{{- define "app.oauth2Proxy.fullname" -}}
{{- printf "%s-oauth2-proxy" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
OAuth2-proxy selector labels.
*/}}
{{- define "app.oauth2Proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-oauth2-proxy" (include "app.name" .) | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Temporal UI upstream service name for admin routing.
*/}}
{{- define "app.temporalUiUpstream.fullname" -}}
{{- printf "%s-temporal-ui-upstream" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Grafana upstream service name for admin routing.
*/}}
{{- define "app.grafanaUpstream.fullname" -}}
{{- printf "%s-grafana-upstream" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Grafana OIDC ConfigMap fully-qualified name.
*/}}
{{- define "app.grafanaOidcConfig.fullname" -}}
{{- printf "%s-grafana-oidc" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Supabase Studio upstream service name for admin routing.
*/}}
{{- define "app.studioUpstream.fullname" -}}
{{- printf "%s-studio-upstream" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Supabase Studio OAuth2-proxy fully-qualified name.
*/}}
{{- define "app.studioOauth2Proxy.fullname" -}}
{{- printf "%s-studio-oauth2-proxy" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Supabase Studio OAuth2-proxy selector labels.
*/}}
{{- define "app.studioOauth2Proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-studio-oauth2-proxy" (include "app.name" .) | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Prometheus upstream service name for admin routing.
*/}}
{{- define "app.prometheusUpstream.fullname" -}}
{{- printf "%s-prometheus-upstream" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Prometheus OAuth2-proxy fully-qualified name.
*/}}
{{- define "app.prometheusOauth2Proxy.fullname" -}}
{{- printf "%s-prometheus-oauth2-proxy" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Prometheus OAuth2-proxy selector labels.
*/}}
{{- define "app.prometheusOauth2Proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-prometheus-oauth2-proxy" (include "app.name" .) | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Alertmanager upstream service name for admin routing.
*/}}
{{- define "app.alertmanagerUpstream.fullname" -}}
{{- printf "%s-alertmanager-upstream" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Alertmanager OAuth2-proxy fully-qualified name.
*/}}
{{- define "app.alertmanagerOauth2Proxy.fullname" -}}
{{- printf "%s-alertmanager-oauth2-proxy" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Alertmanager OAuth2-proxy selector labels.
*/}}
{{- define "app.alertmanagerOauth2Proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-alertmanager-oauth2-proxy" (include "app.name" .) | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Temporal Web UI fully-qualified name.
*/}}
{{- define "app.temporalUi.fullname" -}}
{{- printf "%s-temporal-ui" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Temporal Web UI selector labels.
*/}}
{{- define "app.temporalUi.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-temporal-ui" (include "app.name" .) | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Temporal-worker metrics service fully-qualified name.
*/}}
{{- define "app.temporalWorkerMetrics.fullname" -}}
{{- printf "%s-temporal-worker-metrics" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Return the fully-qualified image reference for a component.
  Usage: {{ include "app.image" (dict "image" .Values.frontend.image "global" .Values.imageRegistry) }}
When image.digest is set the reference uses repo@sha256:… (digest pins are immutable).
When image.digest is empty the reference falls back to repo:tag.
*/}}
{{- define "app.image" -}}
{{- $registry := .image.registry | default .global -}}
{{- $repo := .image.repository -}}
{{- $ref := printf "%s/%s" $registry $repo -}}
{{- if not $registry -}}
{{- $ref = $repo -}}
{{- end -}}
{{- if .image.digest -}}
{{- printf "%s@%s" $ref .image.digest -}}
{{- else -}}
{{- printf "%s:%s" $ref .image.tag -}}
{{- end -}}
{{- end }}
