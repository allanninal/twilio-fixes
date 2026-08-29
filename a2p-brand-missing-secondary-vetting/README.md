# an approved brand with no trust score is throttled to the floor

Registration is finished. status reads APPROVED, the campaign is VERIFIED, numbers are registered, and messages queue up behind a throughput ceiling that nobody set. Sometimes a campaign is refused outright with "brand not qualified to run Campaign for AT&amp;T". The field that explains all of it is brand_score, and it is null.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/a2p-brand-missing-secondary-vetting/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_a2p_brand_vetting_audit.py
node node/twilio-a2p-brand-vetting-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_a2p_brand_vetting_audit.py
node --test node/twilio-a2p-brand-vetting-audit.test.mjs
```
