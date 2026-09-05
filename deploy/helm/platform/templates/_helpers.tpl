{{- define "platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "platform.fullname" -}}
{{- default (printf "%s-%s" .Release.Name (include "platform.name" .)) .Values.fullnameOverride | trunc 48 | trimSuffix "-" -}}
{{- end -}}

{{- define "platform.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "platform.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "platform.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "platform.image" -}}
{{- if .digest -}}
{{- printf "%s@%s" .repository .digest -}}
{{- else -}}
{{- printf "%s:%s" .repository (required "image.tag is required when image.digest is empty" .tag) -}}
{{- end -}}
{{- end -}}

{{- define "platform.databaseEnv" -}}
{{- $secret := ternary .Values.database.migrationCredentialsSecret .Values.database.credentialsSecret (default false .migration) -}}
{{- if default false .worker -}}{{- $secret = .Values.database.workerCredentialsSecret -}}{{- end -}}
- name: PGHOST
  value: {{ .Values.database.host | quote }}
- name: PGPORT
  value: "5432"
- name: PGDATABASE
  value: {{ .Values.database.name | quote }}
- name: PGUSER
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: username }
- name: PGPASSWORD
  valueFrom:
    secretKeyRef: { name: {{ $secret }}, key: password }
- name: PGSSLROOTCERT
  value: /etc/postgres/ca.crt
{{- end -}}

{{- define "platform.messagingEnv" -}}
{{- if .worker }}
- name: QUEUE_REDIS_HOST
  value: {{ .Values.messaging.queueHost | quote }}
- name: QUEUE_REDIS_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.messaging.queueSecret }}, key: password }
- name: KAFKA_BROKERS
  value: {{ .Values.messaging.kafkaBrokers | quote }}
- name: KAFKA_USERNAME
  value: {{ .Values.messaging.kafkaCredentialsSecret | quote }}
- name: KAFKA_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.messaging.kafkaCredentialsSecret }}, key: password }
- name: KAFKA_CA_FILE
  value: /etc/kafka/ca.crt
{{- else }}
- name: ASYNC_ENABLED
  value: "true"
- name: CACHE_REDIS_HOST
  value: {{ .Values.messaging.cacheHost | quote }}
- name: CACHE_REDIS_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.messaging.cacheSecret }}, key: password }
{{- end }}
{{- end -}}
