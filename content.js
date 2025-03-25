chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fillOTP") {
      const otpInput = document.querySelector('input[type="text"][name="otp"]'); // Adjust selector
      if (otpInput) {
        otpInput.value = request.otp;
        console.log("OTP filled:", request.otp);
      }
    }
  });