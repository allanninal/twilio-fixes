# an A2P brand parked at PENDING for weeks with no callback

There is no error to find. errors[] is empty, nothing is red in the console, and every US send still comes back 30034. The brand was submitted five weeks ago, the status callback fired into a service that had not been deployed yet, and since then status has read PENDING with nobody looking at it.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/a2p-brand-stuck-pending-review/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_a2p_brand_stall_audit.py
node node/twilio-a2p-brand-stall-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_a2p_brand_stall_audit.py
node --test node/twilio-a2p-brand-stall-audit.test.mjs
```
