# brand failed 30799: the EIN does not match the legal name

The company has traded under one name since 2019 and everybody, including the people who filled in the registration, calls it that. The IRS calls it something else, ending in , Inc., and The Campaign Registry only reads the IRS. That single disagreement is 30799, and it is the reason behind most Standard brand rejections.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/a2p-brand-tax-id-legal-name-mismatch/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_a2p_brand_identity_audit.py
node node/twilio-a2p-brand-identity-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_a2p_brand_identity_audit.py
node --test node/twilio-a2p-brand-identity-audit.test.mjs
```
