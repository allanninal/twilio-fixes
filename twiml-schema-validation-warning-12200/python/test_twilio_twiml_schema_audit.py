from twilio_twiml_schema_audit import scan, strip_say_children, verdict

GOOD = """<?xml version="1.0" encoding="UTF-8"?>
<Response><Gather numDigits="4" action="/entered"><Say>Enter your code</Say></Gather></Response>"""


def test_a_correct_document_produces_nothing():
    assert scan(GOOD) == []
    assert verdict(scan(GOOD), 0)[0] == "unexplained"


def test_ssml_inside_say_is_not_a_casing_error():
    # The false positive that would get this script switched off.
    doc = '<Response><Say>One<break time="500ms"/>two<say-as>3</say-as></Say></Response>'
    assert scan(doc) == []


def test_a_lowercase_say_is_still_caught_even_though_say_is_exempt():
    doc = "<Response><say>hello<break/></say></Response>"
    findings = scan(doc)
    assert ("verb-casing", "say", "Say") in findings
    assert not any(f[1] == "break" for f in findings)


def test_a_miscased_attribute_names_the_camelcase_form():
    doc = '<Response><Gather numdigits="4"/></Response>'
    state, detail = verdict(scan(doc), 12)
    assert state == "attribute-casing"
    assert "numdigits should be numDigits" in detail
    assert "12 alert(s)" in detail


def test_an_unknown_verb_is_not_reported_as_a_casing_slip():
    state, detail = verdict(scan("<Response><Speak>hi</Speak></Response>"))
    assert state == "unknown-verb"
    assert "not in the TwiML vocabulary" in detail


def test_a_root_that_is_not_response_is_its_own_state():
    state, detail = verdict(scan("<Twiml><Say>hi</Say></Twiml>"))
    assert state == "bad-root"
    assert "<Response>" in detail


def test_a_lowercase_root_is_a_casing_finding_not_a_bad_root():
    assert ("verb-casing", "response", "Response") in scan("<response><Say>hi</Say></response>")


def test_strip_say_children_keeps_the_tags_it_removes_the_contents_of():
    out = strip_say_children("<Response><Say voice=\"alice\"><break/></Say></Response>")
    assert "break" not in out
    assert "<Say voice=" in out and "</Say>" in out
