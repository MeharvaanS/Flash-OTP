function fetchEmails(token) {
    const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread";
    fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
      .then((response) => response.json())
      .then((data) => {
        const messageId = data.messages[0].id;
        fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
          .then((response) => response.json())
          .then((email) => {
            const otp = extractOTP(email.snippet);
            console.log("OTP found:", otp);
            chrome.runtime.sendMessage({ action: "fillOTP", otp: otp });
          });
      });
  }
  
  function extractOTP(text) {
const otpRegex = /(?:one-time passcode|verification code|OTP|passcode)[\s:]*([A-Z0-9]{6,10})(?=\s|$|\.|<)/i;
    const match = text.match(otpRegex);
    return match ? match[0] : null;
  }