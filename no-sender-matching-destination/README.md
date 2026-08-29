# error 21703: the pool has senders but none reach the To

The Messaging Service has senders in it. Sends to the UK go out all day. Every send to a US number comes back 21703, &ldquo;The Messaging Service does not have a phone number available to send a message&rdquo;, which sounds like the pool is empty and is not what it means. The pool is fine. It has nothing in it that can reach that destination.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/no-sender-matching-destination/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_sender_coverage_audit.py
node node/twilio-sender-coverage-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_sender_coverage_audit.py
node --test node/twilio-sender-coverage-audit.test.mjs
```
