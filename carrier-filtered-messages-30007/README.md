# carrier filtering drops your SMS silently with error 30007

The API returned 201. The Message SID is in your logs. The status walked queued, sent, and then undelivered with error_code 30007, and the recipient saw nothing at all. You were billed for the attempt. No HTTP request failed, no webhook errored, nothing appeared in your exception tracker &mdash; a carrier, or Twilio itself, read the message and dropped it.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/carrier-filtered-messages-30007/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_filtered_messages_audit.py
node node/twilio-filtered-messages-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_filtered_messages_audit.py
node --test node/twilio-filtered-messages-audit.test.mjs
```
