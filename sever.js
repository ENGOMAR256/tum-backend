const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'data.json');

const defaultData = {
  users: [
    { id: 'U001', username: 'admin', password: 'admin123', role: 'admin', memberId: null, name: 'System Administrator' }
  ],
  members: [],
  transactions: [],
  loans: [],
  withdrawalRequests: [],
  logs: []
};

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
    return JSON.parse(JSON.stringify(defaultData));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error("Error reading data file, resetting to default", err);
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
    return JSON.parse(JSON.stringify(defaultData));
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

function logAction(user, action, details) {
  db.logs.unshift({
    timestamp: new Date().toLocaleString('en-UG'),
    user: user || 'System',
    action,
    details
  });
  if (db.logs.length > 500) db.logs.pop();
  saveData(db);
}

// ==================== API ROUTES ====================

// Get all data
app.get('/api/data', (req, res) => {
  res.json(db);
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.users.find(u => u.username === username && u.password === password);
  if (user) {
    logAction(user.username, 'Login', 'Successful login');
    res.json({ success: true, user });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

// Create Member & User
app.post('/api/members', (req, res) => {
  const { user, member, transaction, actorName } = req.body;
  db.users.push(user);
  db.members.push(member);
  if (transaction) db.transactions.push(transaction);
  logAction(actorName || 'Admin', 'Create Member', `Created ${member.name} (${member.id})`);
  saveData(db);
  res.json({ success: true, user, member });
});

// Update User Profile
app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const { username, name, password, phone, memberId } = req.body;

  const userIndex = db.users.findIndex(u => u.id === id);
  if (userIndex === -1) return res.status(404).json({ success: false, message: 'User not found' });

  const oldUser = db.users[userIndex];
  db.users[userIndex] = {
    ...oldUser,
    username: username || oldUser.username,
    name: name || oldUser.name,
    password: password || oldUser.password
  };

  if (memberId) {
    const memberIndex = db.members.findIndex(m => m.id === memberId);
    if (memberIndex !== -1) {
      db.members[memberIndex].phone = phone || db.members[memberIndex].phone;
      db.members[memberIndex].name = name || db.members[memberIndex].name;
    }
  }

  logAction(oldUser.username, 'Update Profile', `Updated profile for ${name}`);
  saveData(db);
  res.json({ success: true, user: db.users[userIndex] });
});

// Delete Member (Only way accounts are removed)
app.delete('/api/members/:id', (req, res) => {
  const { id } = req.params;
  const user = db.users.find(u => u.memberId === id);
  const member = db.members.find(m => m.id === id);

  if (!member) return res.status(404).json({ success: false, message: 'Member not found' });

  db.members = db.members.filter(m => m.id !== id);
  if (user) db.users = db.users.filter(u => u.id !== user.id);
  db.transactions = db.transactions.filter(t => t.memberId !== id);
  db.loans = db.loans.filter(l => l.memberId !== id);
  db.withdrawalRequests = db.withdrawalRequests.filter(w => w.memberId !== id);

  logAction('Admin', 'Delete Member', `Deleted member ${member.name} (${id})`);
  saveData(db);
  res.json({ success: true, message: 'Member deleted successfully' });
});

// Add Transaction
app.post('/api/transactions', (req, res) => {
  const { memberId, type, amount, note, actorName } = req.body;
  const member = db.members.find(m => m.id === memberId);
  if (!member) return res.status(404).json({ success: false, message: 'Member not found' });

  const newTx = {
    id: 'T' + String(db.transactions.length + 1).padStart(3, '0'),
    date: new Date().toISOString().split('T')[0],
    memberId,
    member: member.name,
    type,
    amount: parseFloat(amount),
    note
  };

  db.transactions.push(newTx);
  if (type === 'Deposit' || type === 'Share Capital') member.savings += parseFloat(amount);
  else if (type === 'Withdraw') member.savings -= parseFloat(amount);

  logAction(actorName, 'Transaction', `${type} of ${amount} for ${member.name}`);
  saveData(db);
  res.json({ success: true, transaction: newTx });
});

// Create Withdrawal Request
app.post('/api/withdrawals', (req, res) => {
  const { memberId, memberName, amount, note, status, actorName } = req.body;
  const newReq = {
    id: 'W' + String(db.withdrawalRequests.length + 1).padStart(3, '0'),
    date: new Date().toISOString().split('T')[0],
    memberId,
    memberName,
    amount: parseFloat(amount),
    note,
    status
  };
  db.withdrawalRequests.push(newReq);
  logAction(actorName || 'Member', 'Withdrawal Request', `Requested ${amount}`);
  saveData(db);
  res.json({ success: true, request: newReq });
});

// Update Withdrawal Status
app.put('/api/withdrawals/:id', (req, res) => {
  const { id } = req.params;
  const { status, deductFunds, actorName } = req.body;
  const reqIndex = db.withdrawalRequests.findIndex(r => r.id === id);
  if (reqIndex === -1) return res.status(404).json({ success: false });

  const withdrawal = db.withdrawalRequests[reqIndex];
  withdrawal.status = status;

  if (status === 'Completed' && deductFunds) {
    const member = db.members.find(m => m.id === withdrawal.memberId);
    if (member) {
      member.savings -= withdrawal.amount;
      db.transactions.push({
        id: 'T' + String(db.transactions.length + 1).padStart(3, '0'),
        date: new Date().toISOString().split('T')[0],
        memberId: member.id,
        member: member.name,
        type: 'Withdraw',
        amount: withdrawal.amount,
        note: 'Withdrawal Completed'
      });
    }
  }

  logAction(actorName, 'Update Withdrawal', `Set ${id} to ${status}`);
  saveData(db);
  res.json({ success: true });
});

// Request Loan (with 50,000 UGX eligibility check)
app.post('/api/loans', (req, res) => {
  const { memberId, memberName, amount, rate, term, balance, originalBalance, status, actorName } = req.body;
  const member = db.members.find(m => m.id === memberId);

  if (!member) return res.status(404).json({ success: false, message: 'Member not found' });

  const totalEquity = member.savings + member.share;
  if (totalEquity < 50000) {
    return res.status(400).json({
      success: false,
      message: `Loan Denied: Member must have a minimum total equity (Savings + Share Capital) of UGX 50,000. Current equity: UGX ${totalEquity.toLocaleString()}`
    });
  }

  const newLoan = {
    id: 'L' + String(db.loans.length + 1).padStart(3, '0'),
    memberId,
    memberName,
    amount: parseFloat(amount),
    rate: parseFloat(rate),
    term: parseInt(term),
    balance: parseFloat(balance),
    originalBalance: parseFloat(originalBalance),
    status
  };
  db.loans.push(newLoan);
  logAction(actorName, 'Loan Request', `Requested ${amount} for ${memberName}`);
  saveData(db);
  res.json({ success: true, loan: newLoan });
});

// Update Loan (Approve, Reject, Repay)
app.put('/api/loans/:id', (req, res) => {
  const { id } = req.params;
  const { status, amount, actorName } = req.body;
  const loanIndex = db.loans.findIndex(l => l.id === id);
  if (loanIndex === -1) return res.status(404).json({ success: false });

  const loan = db.loans[loanIndex];

  if (status) {
    loan.status = status;
    logAction(actorName, 'Update Loan Status', `Set ${id} to ${status}`);
  }

  if (amount) {
    loan.balance -= parseFloat(amount);
    if (loan.balance <= 0) {
      loan.balance = 0;
      loan.status = 'Completed';
    }
    logAction(actorName, 'Loan Repayment', `Paid ${amount} for ${id}`);
    db.transactions.push({
      id: 'T' + String(db.transactions.length + 1).padStart(3, '0'),
      date: new Date().toISOString().split('T')[0],
      memberId: loan.memberId,
      member: loan.memberName,
      type: 'Loan Repayment',
      amount: parseFloat(amount),
      note: `Repayment for ${id}`
    });
  }

  saveData(db);
  res.json({ success: true, loan });
});

// Smart Reset: Wipes data but PRESERVES all user accounts
app.post('/api/reset', (req, res) => {
  const preservedUsers = JSON.parse(JSON.stringify(db.users));
  const preservedMembers = JSON.parse(JSON.stringify(db.members));

  preservedMembers.forEach(m => {
    m.savings = 0;
    m.share = 0;
  });

  db.transactions = [];
  db.loans = [];
  db.withdrawalRequests = [];
  db.logs = [];
  db.users = preservedUsers;
  db.members = preservedMembers;

  saveData(db);
  logAction('System', 'Smart Reset', 'Transactional data wiped, ALL user accounts preserved');
  res.json({ success: true, message: 'System data reset successfully. All user accounts have been preserved.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ TUM Saving Group Backend running on port ${PORT}`);
});
