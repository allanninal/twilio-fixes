# queue overflow 30001: a send loop outruns one long code

The nightly job dispatched forty thousand messages in about eleven minutes, the way it always has. This time six thousand of them came back with error_code 30001, some of the rest were rejected at request time with 21611, and the ones that survived arrived the following afternoon. Nothing in the code changed. The list got longer, and a single long code can only send about one message a second.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/messaging-queue-overflow-30001/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_queue_overflow_audit.py
node node/twilio-queue-overflow-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_queue_overflow_audit.py
node --test node/twilio-queue-overflow-audit.test.mjs
```
