# SMS Pumping Protection blocks legitimate OTPs with 30450

The one-time passcodes were arriving. Then, for one country, they stopped: error_code 30450, a few hundred of them, over about twenty minutes. By the time the first support ticket reached anyone the sends had resumed on their own and every dashboard was green again. Nothing in your code changed, nothing in the account changed, and there is nothing left to point at &mdash; except a login page where a few hundred people could not get in.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/sms-pumping-protection-30450/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_pumping_block_audit.py
node node/twilio-pumping-block-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_pumping_block_audit.py
node --test node/twilio-pumping-block-audit.test.mjs
```
