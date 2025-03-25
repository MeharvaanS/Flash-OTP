// Update UI based on auth state
function updateUI(isSignedIn) {
    document.getElementById('loginBtn').style.display = isSignedIn ? 'none' : 'block';
    document.getElementById('logoutBtn').style.display = isSignedIn ? 'block' : 'none';
    document.getElementById('fillOTPBtn').style.display = isSignedIn ? 'block' : 'none';
    document.getElementById('status').textContent = isSignedIn ? 'Signed in to Gmail' : 'Please sign in to begin';
}

// Display last OTP info
function updateOTPInfo() {
    chrome.storage.local.get(['lastOTP', 'lastOTPTime', 'lastSender'], (result) => {
        if (result.lastOTP) {
            const time = new Date(result.lastOTPTime).toLocaleTimeString();
            const senderName = result.lastSender || 'unknown sender';
            document.getElementById('lastOTP').style.display = 'block';
            document.getElementById('lastOTP').innerHTML = 
            `<strong>Code from ${senderName.split('.')[0]}:</strong><br>${result.lastOTP}<br><small>at ${time}</small>`;
        }
    });
}

// Update UI based on auth state
function updateUI(isSignedIn) {
    document.getElementById('loginBtn').style.display = isSignedIn ? 'none' : 'block';
    document.getElementById('loggedInUI').style.display = isSignedIn ? 'flex' : 'none';
    document.getElementById('fillOTPBtn').style.display = isSignedIn ? 'block' : 'none';
    document.getElementById('status').textContent = isSignedIn ? 'Signed in to Gmail' : 'Please sign in to begin';
    
    if (isSignedIn) {
        chrome.identity.getProfileUserInfo((userInfo) => {
            const emailIcon = document.getElementById('emailIcon');
            if (userInfo.email) {
                emailIcon.title = `Logged in as ${userInfo.email}`;
                // Also set aria-label for accessibility
                emailIcon.setAttribute('aria-label', `Logged in as ${userInfo.email}`);
            }
        });
    }
}


// Check initial auth state
chrome.storage.local.get(['isSignedIn'], (result) => {
    updateUI(result.isSignedIn || false);
    if (result.isSignedIn) {
        updateOTPInfo();
    }
});

// Sign in handler
document.getElementById('loginBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "authenticate" }, (response) => {
        if (response?.success) {
            updateUI(true);
            chrome.storage.local.set({ isSignedIn: true });
            updateOTPInfo();
        } else {
            document.getElementById('status').textContent = 'Error: ' + (response?.error || 'Authentication failed');
        }
    });
});

// Sign out handler
document.getElementById('logoutBtn').addEventListener('click', () => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (token) {
            // Remove cached token
            chrome.identity.removeCachedAuthToken({ token: token }, () => {
                // Clear all relevant storage
                chrome.storage.local.remove([
                    'isSignedIn', 
                    'gmailToken', 
                    'lastOTP', 
                    'lastOTPTime',
                    'lastProcessedEmailId'
                ], () => {
                    updateUI(false);
                    document.getElementById('lastOTP').style.display = 'none';
                    console.log('Successfully signed out');
                });
            });
            
            // Revoke server-side token
            fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
                .catch(error => console.error('Revoke error:', error));
        }
    });
});

// Fill OTP handler
document.getElementById('fillOTPBtn').addEventListener('click', () => {
    document.getElementById('status').textContent = 'Looking for OTP...';
    chrome.runtime.sendMessage({ action: "checkOTP" }, (response) => {
        if (response?.success) {
            document.getElementById('status').textContent = 'OTP fetched successfully!';
            updateOTPInfo();
        } else {
            document.getElementById('status').textContent = response?.error || 'Try requesting a new OTP!';
        }
    });
});