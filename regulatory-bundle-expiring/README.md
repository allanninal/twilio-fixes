# an approved regulatory bundle is counting down to expiry

Eighteen months of German numbers working perfectly, and then one Tuesday they stop. Nothing was deployed. The bundle that proved your business address to the regulator reached its valid_until, flipped out of twilio-approved on its own, and the numbers attached to it are now non-compliant. There was a date, it was in the API the whole time, and nothing ever mentioned it.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/regulatory-bundle-expiring/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_bundle_expiry_audit.py
node node/twilio-bundle-expiry-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_bundle_expiry_audit.py
node --test node/twilio-bundle-expiry-audit.test.mjs
```
