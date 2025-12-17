// ==UserScript==
// @name         Keylol每日签到
// @namespace    bluebird
// @version      1.0.2
// @description  keylol 每日签到并检测签到状态
// @author       bluebird
// @crontab      * * once * *
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.3.1/jquery.min.js
// @require      https://scriptcat.org/lib/532/1.0.2/ajax.js?sha384-oDDglpYUiMPlZ/QOkx2727Nl9Pw5b5BEX7IZ/5sEgbiboYYMDfwqHbMAk7X7bo/k
// @match        *://keylol.com/*
// @grant       GM_xmlhttpRequest
// @grant       GM_notification
// @connect     keylol.com
// ==/UserScript==


/* global ajax */

return new Promise((resolve, reject) => {
    // 将异步操作封装在内部函数中，避免executor本身是async
    const checkLoginAndCheckinStatus = async () => {
        try {
            // 请求Keylol网站首页
            const html = await ajax('https://keylol.com', {
                method: 'get',
                _nocatch: true,
                timeout: 10000
            });
            
            // 使用jQuery解析HTML内容
            const $ = window.jQuery;
            const $doc = $(html);
            
            // 检查用户操作栏
            const $userActionBar = $doc.find('#nav-user-action-bar ul.list-inline');
            
            // 判断是否包含登录和注册按钮（未登录状态）
            const hasLoginButton = $userActionBar.find('a[href*="member.php?mod=logging&amp;action=login"]').length > 0;
            const hasRegisterButton = $userActionBar.find('a[href*="member.php?mod=register"]').length > 0;
            
            if (hasLoginButton && hasRegisterButton) {
                // 未登录状态
                const errorMsg = "未登录";
                GM_notification({
                    title: "Keylol签到状态",
                    text: errorMsg,
                    timeout: 8000
                });
                reject(errorMsg);
            } else {
                // 已登录状态，检查是否有签到成功的提示脚本
                const checkinSuccessScript = 'showDialog("你已获得今天的体力和蒸汽奖励", "notice", "提示信息", null, 0, null, null, null, null, 10)';
                const isCheckinSuccess = html.includes(checkinSuccessScript);
                
                if (isCheckinSuccess) {
                    // 签到成功
                    GM_notification({
                        title: "Keylol签到状态",
                        text: "已登录，签到成功",
                        timeout: 8000
                    });
                    resolve("已登录，签到成功");
                } else {
                    // 已登录但未检测到新的签到成功提示，说明今日已签到
                    GM_notification({
                        title: "Keylol签到状态",
                        text: "已登录，今日已签到",
                        timeout: 8000
                    });
                    resolve("已登录，今日已签到");
                }
            }
        } catch (error) {
            // 处理请求错误
            const errorMsg = `请求失败: ${error.message}`;
            GM_notification({
                title: "Keylol签到错误",
                text: errorMsg,
                timeout: 8000
            });
            reject(errorMsg);
        }
    };
    
    // 调用异步函数
    checkLoginAndCheckinStatus();
});
