# no status callback means delivery failures never reach you

Your dashboard says every message sent. Support says customers never got them. Both are true: Messages.create returned queued, your code wrote sent, and the undelivered that arrived ninety seconds later went to a status callback that was never configured. The 21610s, the 30007s and the 30034s exist, in Twilio's logs, where nothing you own is looking.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/messaging-service-no-status-callback/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_delivery_observability_audit.py
node node/twilio-delivery-observability-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_delivery_observability_audit.py
node --test node/twilio-delivery-observability-audit.test.mjs
```
