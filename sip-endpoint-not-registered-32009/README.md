# Dial fails with 32009 because the SIP endpoint is not there

PSTN legs work. SIP legs fail. Same TwiML, same account, same day &mdash; the &lt;Dial&gt;&lt;Number&gt; connects and the &lt;Dial&gt;&lt;Sip&gt; beside it comes back 32009 The user you tried to dial is not registered with the corresponding SIP Domain. The error names the endpoint, which reads like it is the endpoint's fault, and about half the time it is not: the softphone is sitting there registered under a username that differs from the one your TwiML asks for by a letter or a capital.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/sip-endpoint-not-registered-32009/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_sip_registration_audit.py
node node/twilio-sip-registration-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_sip_registration_audit.py
node --test node/twilio-sip-registration-audit.test.mjs
```
