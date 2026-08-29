# an empty sender pool fails every send with error 21704

The Messaging Service was created by a setup script in March. It has a friendly name, a SID your application has been passing on every send since, an inbound webhook, a status callback &mdash; and nothing in the sender pool. Every Messages.create against it comes back 21704, &ldquo;The Messaging Service contains no phone numbers&rdquo;, before a carrier is ever involved.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/messaging-service-empty-sender-pool/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_sender_pool_audit.py
node node/twilio-sender-pool-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_sender_pool_audit.py
node --test node/twilio-sender-pool-audit.test.mjs
```
