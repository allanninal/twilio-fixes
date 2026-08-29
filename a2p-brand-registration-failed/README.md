# an A2P brand stuck at FAILED blocks every campaign under it

Campaign creation keeps getting rejected and every US message comes back 30034, so the team keeps looking at the campaign. The campaign is not the problem: the brand above it is FAILED, nothing can attach to a failed brand, and the reason it failed has been sitting in errors[] on the brand resource since the day it was reviewed.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/a2p-brand-registration-failed/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_a2p_brand_audit.py
node node/twilio-a2p-brand-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_a2p_brand_audit.py
node --test node/twilio-a2p-brand-audit.test.mjs
```
