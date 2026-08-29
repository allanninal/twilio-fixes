# a trunk sheds calls at its CPS limit and the average hides it

The dialer starts a campaign and the first second of it is thrown away. 32001 SIP: Trunk CPS limit exceeded, a hundred of them, and then nothing for an hour. Anybody who looks at the hourly call rate sees a number well under the limit and concludes the limit is not the problem. It is: a ceiling measured per second cannot be checked against a rate measured per hour, and every graph you own is drawn at the wrong resolution to show it.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/trunk-cps-limit-exceeded-32001/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_trunk_cps_audit.py
node node/twilio-trunk-cps-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_trunk_cps_audit.py
node --test node/twilio-trunk-cps-audit.test.mjs
```
