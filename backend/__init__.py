"""Nnoel time plugin (backend).

Provides the ``get_local_time`` LLM tool, the ``/plugins/time/timezones/locations``
endpoint used by the Time panel's autocomplete, and the system-prompt
guidance (rule + few-shot examples) that teaches the model how and when
to call the tool. The plugin is discovered and aggregated by
:mod:`backend.plugins.registry` at server startup; no other code needs to
import it directly.
"""
