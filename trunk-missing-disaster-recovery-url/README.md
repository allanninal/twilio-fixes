# a SIP trunk with no disaster recovery URL loses every call

The trunk works. It has worked for a year. Then the PBX reboots, or the firewall rule expires, or the datacentre link flaps for four minutes, and every inbound call in those four minutes is dropped at Twilio &mdash; not sent to voicemail, not answered by an apology, dropped. The field that would have caught them is empty, and it has always been empty, because nothing ever asked you to fill it in.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/trunk-missing-disaster-recovery-url/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_trunk_dr_audit.py
node node/twilio-trunk-dr-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_trunk_dr_audit.py
node --test node/twilio-trunk-dr-audit.test.mjs
```
