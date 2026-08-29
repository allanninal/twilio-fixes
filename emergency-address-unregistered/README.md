# US and Canadian numbers with no registered E911 address

Nothing about this number looks wrong. It answers, it dials out, the webhooks are healthy, and it has been in production for a year. Then somebody on the sales floor dials 911 from a softphone. The call connects to a national emergency call centre with no idea where the caller is, an operator asks for an address the caller may not be able to give, and a $75 pass-through charge turns up on a later invoice.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/emergency-address-unregistered/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_emergency_address_audit.py
node node/twilio-emergency-address-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_emergency_address_audit.py
node --test node/twilio-emergency-address-audit.test.mjs
```
