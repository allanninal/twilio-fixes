# a2p campaign is FAILED and errors[] names the rejected field

The campaign was rejected in March. Somebody resubmitted the same description in April and it was rejected again. The reason was in the response both times: errors[] on the campaign carries a code, a sentence of English and the exact fields that triggered it &mdash; and the dashboard the team built reads campaign_status and stops there.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/a2p-campaign-vetting-failed/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_a2p_campaign_vetting_audit.py
node node/twilio-a2p-campaign-vetting-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_a2p_campaign_vetting_audit.py
node --test node/twilio-a2p-campaign-vetting-audit.test.mjs
```
