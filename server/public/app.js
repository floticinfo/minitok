(function () {
  var SESSION_KEY = "minitok.admin.token";
  var token = sessionStorage.getItem(SESSION_KEY) || null;

  var signinCard = document.getElementById("signin-card");
  var devicesCard = document.getElementById("devices-card");
  var signinError = document.getElementById("signin-error");
  var listStatus = document.getElementById("list-status");

  function show(manager) {
    signinCard.classList.toggle("hidden", manager);
    devicesCard.classList.toggle("hidden", !manager);
  }

  function fmt(iso) {
    if (!iso) return "-";
    var d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString();
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    if (token) options.headers.Authorization = "Bearer " + token;
    return fetch(path, options).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; });
    });
  }

  function render(devices) {
    var rows = document.getElementById("device-rows");
    rows.innerHTML = "";
    devices.forEach(function (d) {
      var tr = document.createElement("tr");
      var badge = d.active
        ? '<span class="badge on">active</span>'
        : '<span class="badge off">' + (d.revoked_at ? "released" : "expired") + "</span>";
      tr.innerHTML =
        "<td><code>" + d.id.slice(0, 8) + "…</code></td>" +
        "<td>" + d.plan + "</td>" +
        "<td>" + badge + "</td>" +
        "<td>" + fmt(d.activated_at) + "</td>" +
        "<td>" + fmt(d.expires_at) + "</td>";
      var td = document.createElement("td");
      if (d.active) {
        var btn = document.createElement("button");
        btn.className = "danger";
        btn.textContent = "Release";
        btn.onclick = function () { releaseDevice(d); };
        td.appendChild(btn);
      }
      tr.appendChild(td);
      rows.appendChild(tr);
    });
    if (!devices.length) listStatus.textContent = "No devices are bound to this key yet.";
  }

  function loadDevices() {
    listStatus.textContent = "";
    api("/api/admin/entitlements").then(function (r) {
      if (r.status === 200) return render(r.body.devices);
      if (r.status === 401) return signOut();
      listStatus.textContent = r.body.error || "Failed to load devices.";
    });
  }

  function releaseDevice(device) {
    if (!confirm("Release this device? The installation will lose access.")) return;
    api("/api/admin/entitlements/" + encodeURIComponent(device.id), { method: "DELETE" }).then(function (r) {
      if (r.status === 200) { loadDevices(); return; }
      listStatus.textContent = r.body.error || "Release failed.";
    });
  }

  function signOut() {
    token = null;
    sessionStorage.removeItem(SESSION_KEY);
    show(false);
  }

  document.getElementById("signin-btn").onclick = function () {
    signinError.textContent = "";
    var key = document.getElementById("key-input").value.trim();
    if (!key) { signinError.textContent = "Please enter a license key."; return; }
    api("/api/admin/session", { method: "POST", body: JSON.stringify({ key: key }) }).then(function (r) {
      if (r.status === 200) {
        token = r.body.token;
        sessionStorage.setItem(SESSION_KEY, token);
        show(true);
        loadDevices();
      } else {
        signinError.textContent = r.body.error || "Sign-in failed.";
      }
    });
  };

  document.getElementById("signout-btn").onclick = signOut;

  show(!!token);
  if (token) loadDevices();
})();
