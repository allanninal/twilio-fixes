# a SUSPENDED brand suspends every campaign underneath it

Nothing was deployed. Nothing was edited. Yesterday's traffic delivered and today every US message comes back 30033 with campaign_status reading SUSPENDED. Editing the campaign returns 21729, editing the brand returns 21731, and the reason both refuse is that the suspension is not on the campaign at all.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/a2p-brand-suspended/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_a2p_brand_suspension_audit.py
node node/twilio-a2p-brand-suspension-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_a2p_brand_suspension_audit.py
node --test node/twilio-a2p-brand-suspension-audit.test.mjs
```
