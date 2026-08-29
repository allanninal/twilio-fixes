# signature validation rejects Twilio with 403 behind a proxy

It works on the laptop with the tunnel running. It works in staging. Then it goes behind the load balancer and every Twilio request comes back 403 from your own middleware &mdash; the code you added to keep other people out. Twilio logs it as 11200, exactly like a 404 or a crash, and the Debugger row looks the same as every other retrieval failure on the account.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/webhook-signature-validation-403-behind-proxy/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_signature_403_audit.py
node node/twilio-signature-403-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_signature_403_audit.py
node --test node/twilio-signature-403-audit.test.mjs
```
