# a failed Event Streams sink drops events and nothing says so

The dashboards flatlined a week ago and everyone assumed volume was down. It was not: an Event Streams sink stopped responding inside its timeout, Twilio marked it failed, and delivery stopped. Every message still sent, every call still connected, and nothing in the message or call logs changed &mdash; the only place this exists is a status field nobody polls.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/event-streams-sink-failed/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_event_sink_audit.py
node node/twilio-event-sink-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_event_sink_audit.py
node --test node/twilio-event-sink-audit.test.mjs
```
