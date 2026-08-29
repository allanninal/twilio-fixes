# inbound SMS disappears into a number with no sms_url

Outbound works perfectly. Replies do not arrive. There is no 4xx, no entry in the Debugger, no request in your access log &mdash; the inbound message is accepted by Twilio, matched to a number, and then delivered to nowhere. The STOP replies vanish the same way, which is the part that eventually costs money.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/inbound-webhook-black-hole/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_inbound_route_audit.py
node node/twilio-inbound-route-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_inbound_route_audit.py
node --test node/twilio-inbound-route-audit.test.mjs
```
