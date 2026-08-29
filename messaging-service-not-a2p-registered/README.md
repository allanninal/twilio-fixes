# a Messaging Service with no A2P campaign fails US sends

Staging was cloned from production last quarter and it has worked ever since &mdash; until the new tenant went live and every US message came back 30034. The brand is approved. The campaign is verified. Neither of them is attached to this Messaging Service, because A2P registration is per service and nobody registers the second one.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/messaging-service-not-a2p-registered/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_a2p_registration_audit.py
node node/twilio-a2p-registration-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_a2p_registration_audit.py
node --test node/twilio-a2p-registration-audit.test.mjs
```
