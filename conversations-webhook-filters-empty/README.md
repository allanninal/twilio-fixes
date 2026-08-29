# Conversations webhooks fire for nothing when filters are empty

post_webhook_url is set. It is the right URL, it is HTTPS, and curl gets a 200 out of it in a second. Messages are being added to conversations all day, and your endpoint has never once been called. There is no error code to look up, because nothing failed: Conversations delivered every event it was asked for, and it was asked for none.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/conversations-webhook-filters-empty/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_conversations_filter_audit.py
node node/twilio-conversations-filter-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_conversations_filter_audit.py
node --test node/twilio-conversations-filter-audit.test.mjs
```
