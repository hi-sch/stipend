{{- define "stipend.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "stipend.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "stipend.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "stipend.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "stipend.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: stipend
{{- if .Values.costAllocation.enabled }}
{{- range $key, $value := .Values.costAllocation.labels }}
{{ $key }}: {{ $value | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "stipend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "stipend.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "stipend.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "stipend.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "stipend.databaseClusterName" -}}
{{- printf "%s-db" (include "stipend.fullname" .) -}}
{{- end -}}

{{/*
Where DATABASE_URL comes from. CloudNativePG publishes a Secret named
<cluster>-app holding a ready-made connection URI for the application database.
*/}}
{{- define "stipend.databaseSecretName" -}}
{{- if .Values.postgres.external.enabled -}}
{{- required "postgres.external.existingSecret is required when postgres.external.enabled" .Values.postgres.external.existingSecret -}}
{{- else -}}
{{- printf "%s-app" (include "stipend.databaseClusterName" .) -}}
{{- end -}}
{{- end -}}

{{- define "stipend.databaseSecretKey" -}}
{{- if .Values.postgres.external.enabled -}}
{{- default "uri" .Values.postgres.external.existingSecretKey -}}
{{- else -}}
uri
{{- end -}}
{{- end -}}

{{/*
The absolute URL this program answers on. An explicit publicUrl wins; otherwise it is
derived from the ingress host when there is one. With neither, it renders empty: the
program still runs, and an operator sets the public URL in Admin -> Settings once traffic
reaches it from outside. Lithic hook and webhook enrollment need it, nothing else does.
*/}}
{{- define "stipend.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- trimSuffix "/" .Values.publicUrl -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- end -}}
{{- end -}}

{{/*
Whether the session cookie may be marked Secure. Tied to how traffic actually arrives, not
to the ingress block alone: marking it Secure when the program is reached over plain HTTP
(a port-forward, a cluster-internal client) means the browser discards it and nobody can
sign in.
*/}}
{{- define "stipend.secureCookies" -}}
{{- $url := include "stipend.publicUrl" . -}}
{{- if hasPrefix "https://" $url -}}1{{- else -}}0{{- end -}}
{{- end -}}

{{/*
Environment shared by the app container and the migration init container, so a migration
never runs against a different database than the one the app will use.
*/}}
{{- define "stipend.env" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "stipend.databaseSecretName" . }}
      key: {{ include "stipend.databaseSecretKey" . }}
- name: HOST
  value: "0.0.0.0"
- name: PORT
  value: {{ .Values.service.targetPort | quote }}
- name: PUBLIC_URL
  value: {{ include "stipend.publicUrl" . | quote }}
- name: STIPEND_SECURE_COOKIES
  value: {{ include "stipend.secureCookies" . | quote }}
- name: STIPEND_REQUIRE_APPROVAL
  value: {{ ternary "1" "0" .Values.approvals.required | quote }}
{{/*
Behind an ingress every request arrives from the controller's own address, so rate limits
keyed on the socket address would treat the whole internet as one client. With this set,
the client address is read from the right-hand end of X-Forwarded-For instead.
*/}}
- name: STIPEND_TRUST_PROXY
  value: {{ ternary "1" "0" .Values.trustProxy | quote }}
{{- if .Values.secrets.encryptionSecretName }}
{{/*
Encrypts the secrets Stipend stores. Every replica reads the same Secret, because a pod
started with a different key — or none — cannot read what the others wrote.
*/}}
- name: STIPEND_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.encryptionSecretName }}
      key: STIPEND_SECRET_KEY
{{- end }}
- name: LOG_FORMAT
  value: {{ .Values.logging.format | quote }}
- name: LOG_LEVEL
  value: {{ .Values.logging.level | quote }}
- name: LITHIC_ENV
  value: {{ .Values.lithic.environment | quote }}
- name: LITHIC_PRODUCT_ID
  value: {{ .Values.lithic.productId | quote }}
- name: MAIL_FROM
  value: {{ .Values.mail.from | quote }}
{{- if .Values.sso.enabled }}
- name: OIDC_ISSUER
  value: {{ required "sso.issuer is required when sso.enabled" .Values.sso.issuer | quote }}
- name: OIDC_CLIENT_ID
  value: {{ .Values.sso.clientId | quote }}
- name: OIDC_REDIRECT_URI
  value: {{ printf "%s/api/auth/oidc/callback" (include "stipend.publicUrl" .) }}
- name: OIDC_SCOPES
  value: {{ .Values.sso.scopes | quote }}
- name: OIDC_GROUPS_CLAIM
  value: {{ .Values.sso.groupsClaim | quote }}
- name: OIDC_ADMIN_GROUP
  value: {{ .Values.sso.adminGroup | quote }}
- name: OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ required "secrets.oidcSecretName is required when sso.enabled" .Values.secrets.oidcSecretName }}
      key: OIDC_CLIENT_SECRET
{{- end }}
{{- end -}}
