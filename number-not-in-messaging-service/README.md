# an SMS number that belongs to no Messaging Service

Nothing is failing. The number sends, the number receives, the console is green, and it has been like that for a year. It is also in no Messaging Service at all, which means every feature that lives on a service &mdash; sticky sender, geomatch, long code failover, and the A2P registration that attaches through a pool &mdash; has never applied to a single message it sent.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/number-not-in-messaging-service/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_unpooled_number_audit.py
node node/twilio-unpooled-number-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_unpooled_number_audit.py
node --test node/twilio-unpooled-number-audit.test.mjs
```
