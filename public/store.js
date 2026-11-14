const products=[
  {sku:'shoe-101',name:'Cloud Runner Sneakers',price:129.99,emoji:'👟',stock:47},
  {sku:'bag-205',name:'Everyday Travel Pack',price:74.5,emoji:'🎒',stock:23},
  {sku:'watch-330',name:'Pulse Smart Watch',price:189,emoji:'⌚',stock:12}
];
let cart=[];
const $=id=>document.getElementById(id);
function money(value){return `$${Number(value).toFixed(2)}`}
function renderProducts(){
  $('products').innerHTML=products.map(product=>`<article class="product"><div class="product-art">${product.emoji}</div><div class="product-body"><h3>${product.name}</h3><div class="price">${money(product.price)}</div><span class="badge">${product.stock} available in the global catalog</span><div class="actions"><button onclick="addToCart('${product.sku}')">Add to cart</button><button class="secondary" onclick="viewInventory('${product.sku}')">Check stock</button></div></div></article>`).join('');
}
function renderCart(){
  if(!cart.length){$('cart').innerHTML='<p class="muted">Your cart is empty. Add an item to create a regional cart update.</p>';return}
  const total=cart.reduce((sum,item)=>sum+item.price*item.qty,0);
  $('cart').innerHTML=cart.map(item=>`<div class="cart-row"><span>${item.name} × ${item.qty}</span><b>${money(item.price*item.qty)}</b></div>`).join('')+`<div class="checkout"><strong>Total ${money(total)}</strong><button onclick="checkout()">Place order</button></div>`;
}
async function save(key,value){const response=await fetch(`/api/records/${encodeURIComponent(key)}?region=${REGION}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value})});return response.json()}
async function addToCart(sku){
  const product=products.find(item=>item.sku===sku);const existing=cart.find(item=>item.sku===sku);
  if(existing) existing.qty++; else cart.push({...product,qty:1});
  const result=await save(`cart:${CUSTOMER}`,{customer:CUSTOMER,items:cart.map(({sku,name,price,qty})=>({sku,name,price,qty})),updatedIn:REGION});
  $('notice').textContent=`Cart saved in ${result.acceptedBy}. Replication is asynchronous to the other regions.`;renderCart();
}
async function viewInventory(sku){
  const product=products.find(item=>item.sku===sku);const result=await save(`inventory:${sku}`,{sku,available:product.stock,reserved:0,checkedIn:REGION});
  $('notice').textContent=`Inventory request accepted by ${result.acceptedBy}. The stock record is durable in PostgreSQL and cached in Redis.`;
}
async function checkout(){
  if(!cart.length)return;
  const order={orderId:`GC-${Date.now()}`,customer:CUSTOMER,items:cart.map(({sku,name,price,qty})=>({sku,name,price,qty})),status:'paid',placedIn:REGION};
  const result=await save(`order:${order.orderId}`,order);$('notice').textContent=`Order ${order.orderId} placed in ${result.acceptedBy} and queued for cross-region replication.`;cart=[];renderCart();
}
renderProducts();renderCart();
