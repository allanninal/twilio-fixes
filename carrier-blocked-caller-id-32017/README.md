# a carrier blocks your caller ID and 32017 is the only notice

Nothing on your side changed and one of your numbers stopped working. 32017 PSTN: Carrier blocked call due to calling number, clustered on one from and, at first, one carrier. There is no setting to correct and no ticket to file with Twilio, because the decision was made by an analytics provider on the terminating carrier's side using data you never see &mdash; except that you do see most of it, in your own call records, in the answer rate and the mean duration that earned the score.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/carrier-blocked-caller-id-32017/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_caller_id_reputation_audit.py
node node/twilio-caller-id-reputation-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_caller_id_reputation_audit.py
node --test node/twilio-caller-id-reputation-audit.test.mjs
```
