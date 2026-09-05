{{- define "observability.log-agent-config" -}}
extensions:
  health_check: { endpoint: '0.0.0.0:13133' }
  file_storage: { directory: /var/lib/otel }
receivers:
  filelog:
    include:
      - /var/log/pods/platform-{{ .Values.environment }}_*/*/*.log
      - /var/log/pods/identity-{{ .Values.environment }}_*/*/*.log
    # Backend JSON logs already arrive over OTLP. Do not ingest them twice.
    exclude: [/var/log/pods/platform-{{ .Values.environment }}_*/backend/*.log, /var/log/pods/platform-{{ .Values.environment }}_*/worker/*.log]
    include_file_path: true
    start_at: beginning
    storage: file_storage
    operators:
      - { type: container, id: container-parser }
processors:
  memory_limiter: { check_interval: 1s, limit_mib: 192, spike_limit_mib: 32 }
  resource:
    attributes:
      - { key: service.name, value: platform-pods, action: insert }
      - { key: deployment.environment.name, value: {{ .Values.environment }}, action: upsert }
  batch: { timeout: 5s }
exporters:
  otlp_http:
    endpoint: http://otel-collector:4318
    sending_queue: { enabled: true, storage: file_storage, queue_size: 1000 }
    retry_on_failure: { enabled: true, max_elapsed_time: 300s }
service:
  extensions: [health_check, file_storage]
  pipelines:
    logs:
      receivers: [filelog]
      processors: [memory_limiter, resource, batch]
      exporters: [otlp_http]
{{- end -}}
